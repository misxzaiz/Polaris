/**
 * 聊天状态栏组件
 *
 * 显示当前对话的状态信息：
 * - 会话配置选择器 (Agent/Model/Effort/Permission)
 * - 引擎健康指示
 * - 输入状态提示 / 流式状态 / 输入字数
 */

import { useState, useCallback, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore, useModelProfileStore } from '@/stores';
import { useInputUIStore } from '@/stores/inputUIStore';
import { useActiveSessionStreaming, useHasPendingQuestion, useHasActivePlan, useActiveSessionUsage, useActiveSessionStreamRate } from '@/stores/conversationStore/useActiveSession';
import { useSessionConfig } from '@/stores/sessionConfigStore';
import { Paperclip, MoreHorizontal, RefreshCw } from 'lucide-react';
import { clsx } from 'clsx';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { SessionConfigSelector } from '../session/SessionConfigSelector';
import { ContextMeter } from './ContextMeter';
import { getSelectedEngineHealth } from '@/utils/engineHealth';
import { normalizeEngineId } from '@/utils/engineDisplay';
import { getEngineSelectors } from '@/utils/engineCapabilities';
import { useActiveSessionId, useSessionMetadataList } from '@/stores/conversationStore/sessionStoreManager';
import { currentMode } from '@/services/transport';
import { useToastStore } from '@/stores/toastStore';

/**
 * 宽度分级阈值（主行可容纳的高频选择器数量）
 */
const BREAKPOINTS = {
  /** 主行可容纳 profile + model + effort，并显示版本号文字 */
  wide: 720,
  /** 主行可容纳 profile + model，并内联输入提示 */
  medium: 560,
  /** 主行仅显示 profile（端点，最高优先级） */
  narrow: 420,
} as const;

type SelectorType = 'agent' | 'model' | 'effort' | 'permission' | 'profile';

/** 主行核心选择器优先级（高频，按宽度从前往后保留） */
const PRIMARY_PRIORITY: SelectorType[] = ['profile', 'model', 'effort'];
/** 低频选择器：始终收纳到「更多」折叠面板 */
const SECONDARY_TYPES: SelectorType[] = ['agent', 'permission'];

/** 根据容器宽度计算主行应显示的选择器类型（再按引擎能力求交集） */
function getVisibleTypes(width: number, engineSelectors: SelectorType[]): SelectorType[] {
  let base: SelectorType[];
  if (width >= BREAKPOINTS.wide) base = ['profile', 'model', 'effort'];
  else if (width >= BREAKPOINTS.medium) base = ['profile', 'model'];
  else if (width >= BREAKPOINTS.narrow) base = ['profile'];
  else base = [];
  return base.filter(t => engineSelectors.includes(t));
}

/** 被折叠到「更多」面板的选择器类型（仅保留当前引擎支持的项） */
function getHiddenTypes(visible: SelectorType[], engineSelectors: SelectorType[]): SelectorType[] {
  const all: SelectorType[] = [...PRIMARY_PRIORITY, ...SECONDARY_TYPES].filter(t => engineSelectors.includes(t));
  return all.filter(t => !visible.includes(t));
}

interface ChatStatusBarProps {
  children?: ReactNode;
  /**
   * 嵌入模式：作为 ChatInput 底栏的中段使用
   * - 去掉外层 border-t/background/px-4（由父容器提供）
   * - 隐藏字数（避免与父布局重复）
   * - 折叠面板使用绝对定位浮出，不占据父容器高度
   */
  embedded?: boolean;
}

/**
 * 聊天状态栏组件
 *
 * 三区布局：[会话操作] │ [配置选择器] … [健康] │ [输入状态]
 * - 配置选择器分层 + 宽度自适应（profile > model > effort，agent/permission 始终折叠）
 * - 引擎版本降级为健康圆点（hover 显示版本号）
 */
export function ChatStatusBar({ children, embedded = false }: ChatStatusBarProps) {
  const { t } = useTranslation('chat');
  const { config, healthStatus } = useConfigStore();
  const isStreaming = useActiveSessionStreaming();
  const activeSessionId = useActiveSessionId();
  const sessionMetadataList = useSessionMetadataList();
  const {
    inputLength,
    attachmentCount,
    suggestionMode,
  } = useInputUIStore();

  // 直接从 conversationStore 获取状态（消除 chatInputStore 冗余同步）
  const hasPendingQuestion = useHasPendingQuestion();
  const hasActivePlan = useHasActivePlan();

  // 会话配置
  const { config: sessionConfig, setConfig: setSessionConfig } = useSessionConfig();

  // token 用量(上下文水位 + 成本)
  const usageStats = useActiveSessionUsage();
  // 流式生成速率(TTFT / TPS)，来自 streamRateTracker
  const streamRate = useActiveSessionStreamRate();
  // 上下文窗口分母:优先事件携带值,其次活动 ModelProfile,再由 ContextMeter 兜底 200K
  const activeProfileContextWindow = useModelProfileStore(
    useCallback((s) => s.getActiveProfile()?.contextWindow, []),
  );

  // 容器宽度监听
  const { ref: containerRef, width: containerWidth } = useContainerWidth();

  // 当前活动引擎：决定哪些配置选择器对该引擎有效（避免展示不兼容的 profile 等）
  const activeSessionMetadata = sessionMetadataList.find(session => session.id === activeSessionId);
  const activeEngineId = normalizeEngineId(activeSessionMetadata?.engineId || config?.defaultEngine);
  const engineSelectors = getEngineSelectors(activeEngineId);

  // 根据宽度 + 引擎能力决定主行显示哪些选择器
  const visibleTypes = getVisibleTypes(containerWidth, engineSelectors);
  const hiddenTypes = getHiddenTypes(visibleTypes, engineSelectors);
  // 是否在健康圆点旁显示版本号文字（窄屏仅显示圆点）
  const showVersionText = containerWidth >= BREAKPOINTS.wide;
  // 上下文水位主行标签密度：宽屏显示 token，中宽显示百分比，窄屏只保留圆圈。
  const contextLabelMode = containerWidth >= BREAKPOINTS.wide
    ? 'full'
    : containerWidth >= BREAKPOINTS.medium
      ? 'percent'
      : 'icon';
  // 输入提示在窄屏退化为图标/圆点，避免挤压发送按钮。
  const showInputHintText = containerWidth >= BREAKPOINTS.medium;

  // 展开/收起
  const [expanded, setExpanded] = useState(false);

  // ===== 同步恢复（Web 模式专用）=====
  // 手机锁屏/切后台导致断线后，手动触发：重连 WS → 重拉会话历史 → 续接新内容
  const [syncing, setSyncing] = useState(false);
  const handleSyncRecover = useCallback(async () => {
    if (syncing) return;
    setSyncing(true);
    const toast = useToastStore.getState();
    try {
      const { manualRefreshActiveSession } = await import('@/services/webReconnectResync');
      const recovered = await manualRefreshActiveSession();
      if (recovered) {
        toast.success(t('statusBar.syncRecoverDone', '已恢复，继续接收新内容'));
      } else {
        toast.info(t('statusBar.syncRecoverNothing', '当前会话无需恢复'));
      }
    } catch (e) {
      toast.error(t('statusBar.syncRecoverFailed', '同步恢复失败'), String(e));
    } finally {
      setSyncing(false);
    }
  }, [syncing, t]);

  // 获取输入状态提示文本
  const getInputHint = () => {
    if (hasPendingQuestion) {
      return { text: t('question.pendingAnswer'), type: 'accent' as const };
    }
    if (hasActivePlan) {
      return { text: t('plan.pendingApproval'), type: 'violet' as const };
    }
    if (suggestionMode === 'workspace') {
      return { text: t('input.selectWorkspace'), type: 'default' as const };
    }
    if (suggestionMode === 'file') {
      return { text: t('input.selectFile'), type: 'default' as const };
    }
    if (suggestionMode === 'git') {
      return { text: t('input.gitContext'), type: 'default' as const };
    }
    if (attachmentCount > 0) {
      return { text: t('input.attachmentCount', { count: attachmentCount }), type: 'default' as const };
    }
    return null;
  };

  const inputHint = getInputHint();

  // 引擎健康指示：绿点=可用，灰点=不可用；版本号收入 tooltip
  // （activeSessionMetadata / activeEngineId 已在上方计算，供选择器裁剪与健康指示共用）
  const selectedEngineHealth = getSelectedEngineHealth(config, healthStatus, activeEngineId);
  const engineTooltip = selectedEngineHealth.available
    ? `${selectedEngineHealth.name}${selectedEngineHealth.version ? ` ${selectedEngineHealth.version}` : ''}`
    : t('statusBar.engineUnavailable', '引擎不可用');
  const healthIndicator = (
    <div className="flex items-center gap-1 shrink-0" title={engineTooltip}>
      <span className={clsx(
        'w-1.5 h-1.5 rounded-full',
        selectedEngineHealth.available ? 'bg-green-500' : 'bg-text-muted',
      )} />
      {showVersionText && selectedEngineHealth.version && (
        <span className="text-text-muted">{selectedEngineHealth.version}</span>
      )}
    </div>
  );

  // 是否有内容被折叠（需要「更多」按钮）：低频选择器（agent/permission）始终折叠
  const hasOverflow = hiddenTypes.length > 0;

  return (
    <div
      ref={containerRef}
      className={clsx(
        'relative grid min-w-0 text-xs text-text-tertiary',
        'transition-[grid-template-rows] duration-200 ease-in-out',
        embedded
          ? 'w-full'
          : 'px-4 bg-background-surface/50 border-t border-border-subtle',
      )}
      style={{
        gridTemplateRows: expanded ? 'auto auto' : 'auto 0fr',
      }}
    >
      {/* 主行：[会话操作] │ [配置选择器] … [健康] │ [输入状态] */}
      <div className={clsx(
        'flex items-center gap-1.5 min-w-0',
        embedded ? 'py-0' : 'py-1.5 gap-2',
      )}>
        {/* 左侧：会话操作 + 配置选择器 + 更多按钮 */}
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {children && (
            <div className="flex items-center gap-1 shrink-0">
              {children}
            </div>
          )}
          {children && !embedded && <span className="w-px h-3.5 bg-border-subtle shrink-0" aria-hidden="true" />}
          {visibleTypes.length > 0 && (
            <div className="min-w-0">
              <SessionConfigSelector
                config={sessionConfig}
                onChange={setSessionConfig}
                disabled={isStreaming}
                visibleTypes={visibleTypes}
              />
            </div>
          )}
          {/* 更多按钮：展开低频配置（agent/permission） */}
          {hasOverflow && (
            <button
              onClick={() => setExpanded(prev => !prev)}
              className={clsx(
                'flex items-center justify-center w-6 h-6 rounded-full transition-colors shrink-0',
                expanded
                  ? 'bg-primary/10 text-primary ring-1 ring-primary/20'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
              )}
              title={expanded ? t('statusBar.collapse', '收起') : t('statusBar.more', '更多设置')}
              aria-expanded={expanded}
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </div>

        {/* 右侧：健康 │ 输入状态 */}
        <div className="flex items-center justify-end gap-1.5 shrink-0 min-w-0">
          {/* 同步恢复（仅 Web 模式）：断线/锁屏后手动补回丢失内容并续接 */}
          {currentMode === 'http' && (
            <button
              onClick={handleSyncRecover}
              disabled={syncing}
              className={clsx(
                'flex items-center px-1.5 py-0.5 rounded-full transition-colors shrink-0',
                syncing
                  ? 'text-primary cursor-wait'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
              )}
              title={t('statusBar.syncRecover', '同步恢复：重连并补回断线丢失的内容')}
            >
              <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            </button>
          )}
          {healthIndicator}

          {usageStats && (
            <ContextMeter usage={usageStats} contextWindow={activeProfileContextWindow} labelMode={contextLabelMode} engineId={activeEngineId} streamRate={streamRate} streaming={isStreaming} />
          )}

          {!embedded && (isStreaming || inputHint || inputLength > 0) && (
            <span className="w-px h-3.5 bg-border-subtle shrink-0" aria-hidden="true" />
          )}

          {/*/!* 流式状态 *!/*/}
          {/*{isStreaming && (*/}
          {/*  <div className="flex items-center gap-1.5">*/}
          {/*    <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />*/}
          {/*    <span className="text-primary">{t('statusBar.responding')}</span>*/}
          {/*  </div>*/}
          {/*)}*/}

          {/* 输入状态提示 */}
          {inputHint && (
            <span
              className={clsx(
                'flex items-center gap-1.5 min-w-0',
                inputHint.type === 'accent' && 'text-accent',
                inputHint.type === 'violet' && 'text-violet-500'
              )}
              title={inputHint.text}
            >
              {inputHint.type !== 'default' && <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse shrink-0" />}
              {attachmentCount > 0 && inputHint.type === 'default' && <Paperclip size={12} className="shrink-0" />}
              {showInputHintText && <span className="truncate max-w-[140px]">{inputHint.text}</span>}
            </span>
          )}

          {/* 字数（嵌入模式由 ChatInput 自行展示） */}
          {!embedded && inputLength > 0 && (
            <span className="text-text-tertiary">{inputLength}</span>
          )}
        </div>
      </div>

      {/* 折叠面板：低频选择器（agent/permission） */}
      {hasOverflow && (
        <div className={clsx(
          'transition-opacity duration-200',
          embedded && 'absolute bottom-full left-0 right-0 mb-1 z-20',
          expanded ? 'opacity-100 overflow-visible' : 'opacity-0 overflow-hidden pointer-events-none',
        )}>
          <div className={clsx(
            'flex flex-col gap-2 py-2',
            embedded
              ? 'px-3 rounded-xl bg-background-elevated border border-border-subtle shadow-xl'
              : 'border-t border-border-subtle/50',
          )}>
            <SessionConfigSelector
              config={sessionConfig}
              onChange={setSessionConfig}
              disabled={isStreaming}
              visibleTypes={hiddenTypes}
              variant="panel"
            />
          </div>
        </div>
      )}
    </div>
  );
}
