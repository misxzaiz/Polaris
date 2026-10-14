/**
 * SessionSummaryCard - 回复摘要卡片（v3 段落折叠 + 筛选式 chips）
 *
 * 形态：一行汇总条 + 点击展开 → 段落折叠式卡片体内
 * - 折叠态：chips 纯计数标签（不可点）
 * - 展开态：chips 变可点击筛选器 → 点击某 chip 只渲染对应段落，其余从 DOM 消失
 * - 再点同一 chip → 取消筛选，恢复全部段落
 *
 * 段落顺序：计划 → 理解分析(运行过程) → 工具调用 → 变更文件 → 产物预览
 * 每段落独立可折叠，有头部行（图标+标题+一行摘要+计数+箭头）。
 * 空白段落（无内容）自动隐藏。
 */

import { memo, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import {
  ChevronRight,
  Layers,
  FileText,
  FilePlus,
  Inbox,
} from 'lucide-react';
import type { ContentBlock } from '@/types';
import {
  extractFileChanges,
  extractProcessBlocks,
  ProcessBlockGroupedList,
} from '../tool-calls/blockGrouping';
import { ArtifactPreviewRenderer } from '../chatBlocks/ArtifactPreviewRenderer';
import { PluginCardHost } from '../chatBlocks/PluginCardHost';
import { useFileEditorStore } from '@/stores/fileEditorStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useChatScrollActions } from '../messages/ChatScrollContext';

/** 段落类型 */
type SectionType = 'process' | 'files' | 'preview';

export const SessionSummaryCard = memo(function SessionSummaryCard({
  blocks,
}: {
  blocks: ContentBlock[];
}) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  /** 筛选激活的段落类型（null = 无筛选，全部段落可见） */
  const [activeFilter, setActiveFilter] = useState<SectionType | null>(null);
  const openFile = useFileEditorStore((s) => s.openFile);
  const currentWorkspace = useWorkspaceStore((s) => {
    const { workspaces, currentWorkspaceId } = s;
    return workspaces.find(w => w.id === currentWorkspaceId) || null;
  });
  /** 滚动豁免：卡片展开/折叠、chips 筛选改变列表高度时禁用跟随，避免消息闪动 */
  const { suspendFollow } = useChatScrollActions();

  // ① 运行过程：过程块
  const processBlocks = useMemo(() => extractProcessBlocks(blocks), [blocks]);

  // ② 变更文件
  const fileChanges = useMemo(() => extractFileChanges(blocks), [blocks]);

  // ③ 预览
  const previews = useMemo(
    () => blocks.filter((b) => b.type === 'artifact_preview' || b.type === 'plugin_card'),
    [blocks]
  );

  // 运行过程段落按类型细分（思考/工具/计划/权限…），供 chips 展示与筛选
  const processTypeGroups = useMemo(() => {
    const map = new Map<string, ContentBlock[]>();
    for (const b of processBlocks) {
      const key = getProcessChipKey(b);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(b);
    }
    return [...map.entries()];
  }, [processBlocks]);

  // chips 数据：过程块按类型细分 chip（标签区分思考/工具/计划…），
  // 点击筛选仍归到 process 段落（筛选粒度=段落，段落内再按类型分组折叠）
  const chips = useMemo(() => {
    const items: { type: SectionType; label: string; color: string; count: number }[] = [];

    // 每个过程类型一个 chip（用 summary.chip* 文案），不再笼统归为"思考"
    for (const [key, blocks] of processTypeGroups) {
      const cfg = PROCESS_CHIP_CONFIG[key];
      if (!cfg) continue;
      items.push({
        type: 'process',
        label: t(cfg.labelKey, { count: blocks.length }),
        color: cfg.color,
        count: blocks.length,
      });
    }

    if (fileChanges.length > 0)
      items.push({ type: 'files', label: t('summary.chipFile', { count: fileChanges.length }), color: 'green', count: fileChanges.length });
    if (previews.length > 0)
      items.push({ type: 'preview', label: t('summaryCard.chipPreview', { count: previews.length }), color: 'cyan', count: previews.length });
    return items;
  }, [processTypeGroups, fileChanges.length, previews.length, t]);

  const hasContent = chips.length > 0;

  // chip 点击：筛选切换（列表高度将变化 → 豁免窗口内不跟随）
  const handleChipClick = useCallback((type: SectionType) => {
    suspendFollow();
    setActiveFilter(prev => prev === type ? null : type);
  }, [suspendFollow]);

  // 段落是否可见（受筛选控制）
  const isSectionVisible = (type: SectionType) => activeFilter === null || activeFilter === type;

  // 折叠时清除筛选（列表高度将变化 → 豁免窗口内不跟随）
  const handleToggleExpand = useCallback(() => {
    suspendFollow();
    setExpanded(prev => {
      if (prev) setActiveFilter(null); // 折叠时清除
      return !prev;
    });
  }, [suspendFollow]);

  const handleOpenFile = useCallback((filePath: string) => {
    // 相对路径 → 绝对路径（复用 workspace 根路径合成），与 ToolCallBlockRenderer 一致
    const isAbsolute = filePath.startsWith('/') || /^[A-Za-z]:[\\/]/.test(filePath);
    const absolutePath = isAbsolute
      ? filePath
      : currentWorkspace
        ? (currentWorkspace.path.replace(/[\\/]+$/, '') + '/' + filePath.replace(/^[\\/]+/, ''))
        : filePath;
    const fileName = absolutePath.split(/[/\\]/).pop() || absolutePath;
    openFile(absolutePath, fileName);
  }, [openFile, currentWorkspace]);

  if (!hasContent) return null;

  return (
    <div
      className={clsx(
        'flex flex-col my-1 rounded-md bg-background-surface',
        'border transition-colors',
        expanded ? 'border-border' : 'border-dashed border-border',
      )}
    >
      {/* 汇总条（卡片头部） */}
      <div
        className={clsx(
          'flex items-center gap-1.5 px-3 py-2 min-h-[44px]',
          'cursor-pointer text-xs text-text-secondary rounded-md',
          'transition-all duration-150',
          expanded ? 'border-b border-border' : 'hover:bg-background-hover hover:border-primary hover:text-primary',
          !expanded && 'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background-base'
        )}
        onClick={handleToggleExpand}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            handleToggleExpand();
          }
        }}
        aria-expanded={expanded}
      >
        <Layers className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
        <span className="text-xs font-medium text-text-secondary flex-shrink-0">
          {t('summary.collapsedLabel')}
        </span>
        {/* chips：折叠态纯标签，展开态可点击筛选 */}
        <span className="flex-1 min-w-0 flex items-center gap-1 flex-wrap">
          {chips.map(chip => (
            <span
              key={chip.type}
              className={clsx(
                'text-[11px] px-2 py-0.5 rounded-full font-medium transition-all border',
                expanded ? 'cursor-pointer' : 'cursor-default',
                activeFilter === chip.type
                  ? chipColorActive(chip.color)
                  : chipColorIdle(chip.color),
              )}
              onClick={expanded ? (e) => { e.stopPropagation(); handleChipClick(chip.type); } : undefined}
            >
              {chip.label}
            </span>
          ))}
        </span>
        {expanded ? (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 rotate-90 transition-transform" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 shrink-0 transition-transform" />
        )}
      </div>

      {/* 展开态：段落折叠式卡片体 */}
      {expanded && (
        <div className="flex flex-col">
          {/* 段落：运行过程 */}
          {isSectionVisible('process') && processBlocks.length > 0 && (
            <ProcessBlockGroupedList processBlocks={processBlocks} bare />
          )}

          {/* 段落：变更文件 */}
          {isSectionVisible('files') && fileChanges.length > 0 && (
            <FilesSection
              fileChanges={fileChanges}
              onOpenFile={handleOpenFile}
              t={t}
            />
          )}

          {/* 段落：产物预览 */}
          {isSectionVisible('preview') && previews.length > 0 && (
            <PreviewSection previews={previews} />
          )}
        </div>
      )}
    </div>
  );
});

// ============================================================
// 变更文件段落
// ============================================================
const FilesSection = memo(function FilesSection({
  fileChanges, onOpenFile, t,
}: {
  fileChanges: ReturnType<typeof extractFileChanges>;
  onOpenFile: (path: string) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  const { suspendFollow } = useChatScrollActions();
  const summary = useMemo(() => {
    const names = fileChanges.map(f => f.fileName);
    return names.slice(0, 3).join(' · ') + (names.length > 3 ? ' …' : '');
  }, [fileChanges]);

  // 展开/收起会改变列表项高度 → 豁免窗口内不跟随，防止内容被滚走
  const handleToggle = useCallback(() => {
    suspendFollow();
    setOpen(o => !o);
  }, [suspendFollow]);

  return (
    <div className="border-t border-border first:border-t-0">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-background-hover transition-colors min-h-[44px]"
        onClick={handleToggle}
      >
        <FileText className="w-3.5 h-3.5 text-green-400 flex-shrink-0" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider flex-shrink-0">
          {t('summary.fileChangesTitle')}
        </span>
        <span className="text-[11px] text-text-tertiary flex-1 min-w-0 truncate">{summary}</span>
        <span className="text-[10px] text-text-muted flex-shrink-0">{fileChanges.length}</span>
        <ChevronRight className={clsx('w-3 h-3 text-text-muted flex-shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="max-h-[40vh] overflow-y-auto">
          {fileChanges.map((fc) => (
            <div
              key={fc.fullPath}
              className="flex items-center gap-2 px-3 py-2 text-xs cursor-pointer hover:bg-background-hover border-b border-border last:border-b-0 min-h-[44px]"
              onClick={() => onOpenFile(fc.fullPath)}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onOpenFile(fc.fullPath);
                }
              }}
              title={fc.fullPath}
            >
              {fc.changeType === 'created' ? (
                <FilePlus className="w-3.5 h-3.5 shrink-0 text-green-400" />
              ) : (
                <FileText className={clsx('w-3.5 h-3.5 shrink-0', fc.changeType === 'deleted' ? 'text-red-400' : 'text-orange-400')} />
              )}
              <span className="text-xs font-medium text-text-primary truncate">{fc.fileName}</span>
              <span className="text-[11px] text-text-muted/60 flex-1 min-w-0 truncate">{fc.dirPath}</span>
              <span className={clsx(
                'shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium',
                fc.changeType === 'created'
                  ? 'bg-green-500/10 text-green-400'
                  : fc.changeType === 'deleted'
                    ? 'bg-red-500/10 text-red-400'
                    : 'bg-orange-500/10 text-orange-400'
              )}>
                {fc.changeType === 'created' ? t('summary.fileCreated')
                  : fc.changeType === 'deleted' ? t('summary.fileDeleted')
                  : t('summary.fileModified')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

// ============================================================
// 产物预览段落
// ============================================================
const PreviewSection = memo(function PreviewSection({
  previews,
}: {
  previews: ContentBlock[];
}) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const { suspendFollow } = useChatScrollActions();
  const summary = useMemo(() => {
    const titles = previews.map(b => {
      if (b.type === 'artifact_preview') return b.title || t('summaryCard.tabPreview');
      return t('summaryCard.tabPreview');
    });
    return titles.slice(0, 3).join(' · ');
  }, [previews, t]);

  // 展开/收起会改变列表项高度 → 豁免窗口内不跟随，防止内容被滚走
  const handleToggle = useCallback(() => {
    suspendFollow();
    setOpen(o => !o);
  }, [suspendFollow]);

  return (
    <div className="border-t border-border first:border-t-0">
      <button
        className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-background-hover transition-colors min-h-[44px]"
        onClick={handleToggle}
      >
        <Inbox className="w-3.5 h-3.5 text-cyan-400 flex-shrink-0" />
        <span className="text-[11px] font-semibold text-text-secondary uppercase tracking-wider flex-shrink-0">
          {t('summaryCard.tabPreview')}
        </span>
        <span className="text-[11px] text-text-tertiary flex-1 min-w-0 truncate">{summary}</span>
        <span className="text-[10px] text-text-muted flex-shrink-0">{previews.length}</span>
        <ChevronRight className={clsx('w-3 h-3 text-text-muted flex-shrink-0 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="flex flex-col gap-2 p-2">
          {previews.map((b) => {
            if (b.type === 'artifact_preview') {
              return (
                <div key={b.previewId}>
                  <ArtifactPreviewRenderer block={b} />
                </div>
              );
            }
            if (b.type === 'plugin_card') {
              return (
                <div key={b.id}>
                  <PluginCardHost block={b} />
                </div>
              );
            }
            return null;
          })}
        </div>
      )}
    </div>
  );
});

// ============================================================
// 辅助
// ============================================================

/** 过程块 → chip 细分 key（与 blockGrouping 的分组 key 对齐） */
function getProcessChipKey(block: ContentBlock): string {
  switch (block.type) {
    case 'thinking': return 'thinking';
    case 'tool_call':
    case 'tool_group': return 'tools';
    case 'plan_mode': return 'plan';
    case 'permission_request': return 'permission';
    case 'agent_run': return 'agent';
    case 'question': return 'question';
    case 'context_compact': return 'compact';
    default: return 'other';
  }
}

/** 过程 chip 配置：文案 key + 颜色 */
const PROCESS_CHIP_CONFIG: Record<string, { labelKey: string; color: string }> = {
  thinking: { labelKey: 'summary.chipThinking', color: 'purple' },
  tools: { labelKey: 'summary.chipTool', color: 'blue' },
  plan: { labelKey: 'summary.chipPlan', color: 'yellow' },
  permission: { labelKey: 'summary.chipPermission', color: 'orange' },
  agent: { labelKey: 'summary.chipAgent', color: 'cyan' },
  question: { labelKey: 'summary.chipQuestion', color: 'red' },
  compact: { labelKey: 'summary.chipCompact', color: 'grey' },
  other: { labelKey: 'summary.chipText', color: 'grey' },
};

/** chip 激活态样式（实心背景） */
function chipColorActive(color: string): string {
  switch (color) {
    case 'purple': return 'bg-purple-400 text-white border-purple-400';
    case 'green': return 'bg-green-400 text-black border-green-400';
    case 'cyan': return 'bg-cyan-400 text-black border-cyan-400';
    case 'blue': return 'bg-blue-400 text-white border-blue-400';
    case 'yellow': return 'bg-yellow-400 text-black border-yellow-400';
    case 'orange': return 'bg-orange-400 text-black border-orange-400';
    case 'red': return 'bg-red-400 text-white border-red-400';
    case 'grey': return 'bg-text-muted text-white border-text-muted';
    default: return 'bg-primary text-white border-primary';
  }
}

/** chip 非激活态样式（半透明） */
function chipColorIdle(color: string): string {
  switch (color) {
    case 'purple': return 'bg-background-elevated text-purple-400 border-transparent';
    case 'green': return 'bg-background-elevated text-green-400 border-transparent';
    case 'cyan': return 'bg-background-elevated text-cyan-400 border-transparent';
    case 'blue': return 'bg-background-elevated text-blue-400 border-transparent';
    case 'yellow': return 'bg-background-elevated text-yellow-400 border-transparent';
    case 'orange': return 'bg-background-elevated text-orange-400 border-transparent';
    case 'red': return 'bg-background-elevated text-red-400 border-transparent';
    case 'grey': return 'bg-background-elevated text-text-muted border-transparent';
    default: return 'bg-background-elevated text-text-muted border-transparent';
  }
}
