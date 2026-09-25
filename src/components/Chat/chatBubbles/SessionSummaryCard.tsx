/**
 * SessionSummaryCard - 回复摘要卡片
 *
 * 延续"运行过程已折叠"卡片语言（一行汇总条 + 点击展开），
 * 挂载于每条 AI 回复（AssistantBubble）正文之后，作为消息流内的补充内容。
 * 消息内（AutoModeRenderer）不再渲染"运行过程已折叠"，统一由本卡片承载。
 *
 * 展开后为三 tab 切换（均从 message.blocks 派生，复用现有渲染器）：
 * ① 运行过程 → ProcessBlockGroupedList（thinking / tool_call / plan_mode …）
 * ② 变更文件 → 文件列表（extractFileChanges），点击跳转编辑器
 * ③ 预览     → artifact_preview / plugin_card(result) 渲染（PRD 预览 / MCP 产物）
 *
 * 空白 tab 自动隐藏；仅剩一个 tab 时不显示 tab 栏。
 * 无任何内容的回复整卡不渲染。宽度由容器（chat-assistant-content）约束。
 */

import { memo, useMemo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import {
  ChevronRight,
  ChevronUp,
  FileText,
  FilePlus,
  Inbox,
  Layers,
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

type SummaryTab = 'process' | 'files' | 'preview';

export const SessionSummaryCard = memo(function SessionSummaryCard({
  blocks,
}: {
  /** 该条 AI 消息的全部内容块（用于派生卡片数据） */
  blocks: ContentBlock[];
}) {
  const { t } = useTranslation('chat');
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<SummaryTab>('preview');
  const openFile = useFileEditorStore((s) => s.openFile);

  // ① 运行过程：过程块（与 AutoModeRenderer 折叠集合同一语义）
  const processBlocks = useMemo(() => extractProcessBlocks(blocks), [blocks]);

  // ② 变更文件：从 tool_call 派生
  const fileChanges = useMemo(() => extractFileChanges(blocks), [blocks]);

  // ③ 预览：artifact_preview + plugin_card（result 模式）
  const previews = useMemo(
    () => blocks.filter((b) => b.type === 'artifact_preview' || b.type === 'plugin_card'),
    [blocks]
  );

  // 空卡片判定：三类内容全空则不渲染（置于所有 hooks 之后，避免条件 hook 调用）
  const hasContent = processBlocks.length > 0 || fileChanges.length > 0 || previews.length > 0;

  // 按类型统计数量（chips，复用"运行过程已折叠"同款统计）
  const counts = useMemo(() => {
    let thinking = 0, tool = 0, plan = 0;
    for (const b of processBlocks) {
      if (b.type === 'thinking') thinking++;
      else if (b.type === 'tool_call') tool++;
      else if (b.type === 'plan_mode') plan++;
    }
    return { thinking, tool, plan };
  }, [processBlocks]);

  // 汇总条 chips
  const chips = useMemo(() => {
    const items: React.ReactNode[] = [];
    const add = (key: string, label: string, className: string) => {
      items.push(
        <span key={key} className={clsx('text-[11px] px-2 py-0.5 rounded-full', 'bg-background-elevated text-text-muted', className)}>
          {label}
        </span>
      );
    };
    if (counts.thinking) add('think', t('summary.chipThinking', { count: counts.thinking }), 'text-purple-400');
    if (counts.tool)     add('tool', t('summary.chipTool', { count: counts.tool }), 'text-blue-400');
    if (counts.plan)     add('plan', t('summary.chipPlan', { count: counts.plan }), 'text-yellow-400');
    if (fileChanges.length) add('file', t('summary.chipFile', { count: fileChanges.length }), 'text-green-400');
    if (previews.length)     add('preview', t('summaryCard.chipPreview', { count: previews.length }), 'text-cyan-400');
    return items;
  }, [counts, fileChanges, previews, t]);

  // 打开文件
  const handleOpenFile = useCallback((filePath: string) => {
    const fileName = filePath.split(/[/\\]/).pop() || filePath;
    openFile(filePath, fileName);
  }, [openFile]);

  // Tab 定义：空白自动隐藏。顺序：预览等其它在前 → 变更文件 → 运行过程（最后）
  const tabs: { key: SummaryTab; label: string; icon: React.ReactNode; visible: boolean }[] = [
    { key: 'preview', label: t('summaryCard.tabPreview'), icon: <Inbox className="w-3.5 h-3.5" />, visible: previews.length > 0 },
    { key: 'files', label: t('summary.fileChangesTitle'), icon: <FileText className="w-3.5 h-3.5" />, visible: fileChanges.length > 0 },
    { key: 'process', label: t('summary.toolbarTitle'), icon: <Layers className="w-3.5 h-3.5" />, visible: processBlocks.length > 0 },
  ];
  const visibleTabs = tabs.filter((x) => x.visible);

  // 当前 tab 失活（内容变化后隐藏）时回退到第一个可见 tab
  const activeTab: SummaryTab = visibleTabs.some((x) => x.key === tab) ? tab : (visibleTabs[0]?.key ?? 'process');

  // 空卡片：三类内容全空则不渲染
  if (!hasContent) return null;

  return (
    <>
      {/* 外层容器：折叠时为虚线卡片，展开后为实线整体（汇总条 + tab 内容同框，边框连贯） */}
      <div
        className={clsx(
          'flex flex-col my-1 rounded-md bg-background-surface',
          expanded ? 'border border-border' : 'border border-dashed border-border'
        )}
      >
        {/* 汇总条 */}
        <div
          className={clsx(
            'flex items-center gap-1.5 px-3 py-2',
            'cursor-pointer text-xs text-text-secondary rounded-md',
            'transition-all duration-150',
            expanded ? 'border-b border-border' : 'hover:bg-background-hover hover:border-primary hover:text-primary',
            !expanded &&
              'focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2 focus:ring-offset-background-base'
          )}
          onClick={() => setExpanded(!expanded)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setExpanded(!expanded);
            }
          }}
          aria-expanded={expanded}
        >
          <span className="flex-1 min-w-0 flex items-center gap-2 flex-wrap">
            {t('summary.collapsedLabel')}
            {chips}
          </span>
          {expanded ? (
            <ChevronUp className="w-3.5 h-3.5 shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0" />
          )}
        </div>

        {/* 展开态：三 tab 切换（与汇总条同框） */}
        {expanded && (
          <>
            {/* Tab 栏：仅当多于一个 tab 时显示 */}
            {visibleTabs.length > 1 && (
              <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border bg-background-elevated">
                {visibleTabs.map((tb) => (
                  <button
                    key={tb.key}
                    onClick={() => setTab(tb.key)}
                    className={clsx(
                      'flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs transition-colors',
                      activeTab === tb.key
                        ? 'bg-background-base text-text-primary font-medium shadow-sm'
                        : 'text-text-muted hover:text-text-secondary hover:bg-background-hover'
                    )}
                  >
                    {tb.icon}
                    {tb.label}
                  </button>
                ))}
              </div>
            )}

            {/* Tab 内容：扁平化渲染（无嵌套边框/顶栏，由 tab 栏表明语义） */}
            <div>
              {activeTab === 'process' && processBlocks.length > 0 && (
                <ProcessBlockGroupedList processBlocks={processBlocks} bare />
              )}

            {activeTab === 'files' && fileChanges.length > 0 && (
              <div className="flex flex-col" style={{ maxHeight: '40vh', overflowY: 'auto' }}>
                {fileChanges.map((fc, i) => (
                  <div
                    key={fc.fullPath}
                    className={clsx(
                      'flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer transition-colors hover:bg-background-hover border-b border-border last:border-b-0',
                      i < fileChanges.length - 1 && 'border-b border-border'
                    )}
                    onClick={() => handleOpenFile(fc.fullPath)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        handleOpenFile(fc.fullPath);
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

            {activeTab === 'preview' && previews.length > 0 && (
              <div className="flex flex-col gap-2 p-2">
                {previews.map((b) => (
                  <div key={b.type === 'artifact_preview' ? b.previewId : b.id}>
                    {b.type === 'artifact_preview' ? (
                      <ArtifactPreviewRenderer block={b} />
                    ) : (
                      <PluginCardHost block={b} />
                    )}
                  </div>
                ))}
              </div>
            )}
            </div>
          </>
        )}
      </div>
    </>
  );
});
