/**
 * 聊天状态栏组件
 *
 * 显示当前对话的状态信息：
 * - 会话配置选择器 (Agent/Model/Effort/Permission)
 * - 引擎健康指示
 * - 语音伙伴「小白」入口
 * - 输入状态提示 / 流式状态 / 输入字数
 */

import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useConfigStore, useSessionStore } from '@/stores';
import { useActiveSessionStreaming, useHasPendingQuestion, useHasActivePlan } from '@/stores/conversationStore/useActiveSession';
import { useSessionConfig } from '@/stores/sessionConfigStore';
import { Paperclip, MoreHorizontal } from 'lucide-react';
import { clsx } from 'clsx';
import { IconMic } from '../Common/Icons';
import { useContainerWidth } from '@/hooks/useContainerWidth';
import { SessionConfigSelector } from './SessionConfigSelector';
import { getSelectedEngineHealth } from '@/utils/engineHealth';
import { normalizeEngineId } from '@/utils/engineDisplay';
import { useActiveSessionId, useSessionMetadataList } from '@/stores/conversationStore/sessionStoreManager';
import { useVoiceCompanionStore } from '@/stores/voiceCompanionStore';

/**
 * 宽度分级阈值（主行可容纳的高频选择器数量）
 *
 * 选择器分两层：
 * - 主行（高频，按宽度收敛）：profile > model > effort
 * - 折叠面板（低频，始终收纳）：agent、permission
 */
const BREAKPOINTS = {
  /** 主行可容纳 profile + model + effort，并显示版本号文字 */
  wide: 600,
  /** 主行可容纳 profile + model */
  medium: 360,
  /** 主行仅显示 profile（端点，最高优先级） */
  narrow: 260,
} as const;

type SelectorType = 'agent' | 'model' | 'effort' | 'permission' | 'profile';

/** 主行核心选择器优先级（高频，按宽度从前往后保留） */
const PRIMARY_PRIORITY: SelectorType[] = ['profile', 'model', 'effort'];
/** 低频选择器：始终收纳到「更多」折叠面板 */
const SECONDARY_TYPES: SelectorType[] = ['agent', 'permission'];

/** 根据容器宽度计算主行应显示的选择器类型 */
function getVisibleTypes(width: number): SelectorType[] {
  if (width >= BREAKPOINTS.wide) return ['profile', 'model', 'effort'];
  if (width >= BREAKPOINTS.medium) return ['profile', 'model'];
  if (width >= BREAKPOINTS.narrow) return ['profile'];
  return [];
}

/** 被折叠到「更多」面板的选择器类型（低频 + 主行放不下的高频） */
function getHiddenTypes(visible: SelectorType[]): SelectorType[] {
  const all: SelectorType[] = [...PRIMARY_PRIORITY, ...SECONDARY_TYPES];
  return all.filter(t => !visible.includes(t));
}

interface ChatStatusBarProps {
  children?: ReactNode;
}

/**
 * 聊天状态栏组件
 *
 * 四区布局：[会话操作] │ [配置选择器] … [工具/健康] │ [输入状态]
 * - 配置选择器分层 + 宽度自适应（profile > model > effort，agent/permission 始终折叠）
 * - 引擎版本降级为健康圆点（hover 显示版本号）
 * - 语音伙伴入口常驻右侧工具区（不随宽度折叠，保证可发现性）
 */
export function ChatStatusBar({ children }: ChatStatusBarProps) {
  const { t } = useTranslation('chat');
  const { config, healthStatus } = useConfigStore();
  const isStreaming = useActiveSessionStreaming();
  const activeSessionId = useActiveSessionId();
  const sessionMetadataList = useSessionMetadataList();
  const {
    inputLength,
    attachmentCount,
    suggestionMode,
  } = useSessionStore();

  // 直接从 conversationStore 获取状态（消除 chatInputStore 冗余同步）
  const hasPendingQuestion = useHasPendingQuestion();
  const hasActivePlan = useHasActivePlan();

  // 会话配置
  const { config: sessionConfig, setConfig: setSessionConfig } = useSessionConfig();

  // 容器宽度监听
  const { ref: containerRef, width: containerWidth } = useContainerWidth();

  // 根据宽度决定主行显示哪些选择器
  const visibleTypes = getVisibleTypes(containerWidth);
  const hiddenTypes = getHiddenTypes(visibleTypes);
  // 是否在健康圆点旁显示版本号文字（窄屏仅显示圆点）
  const showVersionText = containerWidth >= BREAKPOINTS.wide;

  // 展开/收起
  const [expanded, setExpanded] = useState(false);

  // 语音伙伴入口
  const openVoiceCompanion = useVoiceCompanionStore((s) => s.open);

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

  // 引擎健康指示（替代醒目的版本徽章）：绿点=可用，灰点=不可用；版本号收入 tooltip
  const activeSessionMetadata = sessionMetadataList.find(session => session.id === activeSessionId);
  const activeEngineId = normalizeEngineId(activeSessionMetadata?.engineId || config?.defaultEngine);
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

  // 语音伙伴入口按钮（常驻右侧，点击打开全屏通话）
  const voiceCompanionButton = (
    <button
      onClick={openVoiceCompanion}
      className="flex items-center gap-1 px-1.5 py-0.5 rounded transition-colors shrink-0 text-text-tertiary hover:text-text-primary hover:bg-background-hover"
      title={t('voiceCompanion.entry', '和小白语音聊天')}
    >
      <IconMic size={14} />
    </button>
  );

  return (
    <div
      ref={containerRef}
      className={clsx(
        'grid px-4 text-xs text-text-tertiary',
        'bg-background-surface/50 border-t border-border-subtle',
        'transition-[grid-template-rows] duration-200 ease-in-out',
      )}
      style={{
        gridTemplateRows: expanded ? 'auto auto' : 'auto 0fr',
      }}
    >
      {/* 主行：[会话操作] │ [配置选择器] … [工具/健康] │ [输入状态] */}
      <div className="flex items-center justify-between gap-2 py-1.5 min-w-0">
        {/* 左侧：会话操作 + 配置选择器 + 更多按钮 */}
        <div className="flex items-center gap-2 min-w-0">
          {children}
          {children && <span className="w-px h-3.5 bg-border-subtle shrink-0" aria-hidden="true" />}
          {visibleTypes.length > 0 && (
            <SessionConfigSelector
              config={sessionConfig}
              onChange={setSessionConfig}
              disabled={isStreaming}
              visibleTypes={visibleTypes}
            />
          )}
          {/* 更多按钮：展开低频配置（agent/permission） */}
          {hasOverflow && (
            <button
              onClick={() => setExpanded(prev => !prev)}
              className={clsx(
                'flex items-center px-1.5 py-0.5 rounded transition-colors shrink-0',
                expanded
                  ? 'bg-primary/10 text-primary'
                  : 'text-text-tertiary hover:text-text-primary hover:bg-background-hover',
              )}
              title={expanded ? t('statusBar.collapse', '收起') : t('statusBar.more', '更多设置')}
            >
              <MoreHorizontal size={14} />
            </button>
          )}
        </div>

        {/* 右侧：工具/健康 │ 输入状态 */}
        <div className="flex items-center gap-2 shrink-0">
          {voiceCompanionButton}
          {healthIndicator}

          {(isStreaming || inputHint || inputLength > 0) && (
            <span className="w-px h-3.5 bg-border-subtle shrink-0" aria-hidden="true" />
          )}

          {/* 流式状态 */}
          {isStreaming && (
            <div className="flex items-center gap-1.5">
              <span className="w-1.5 h-1.5 bg-primary rounded-full animate-pulse" />
              <span className="text-primary">{t('statusBar.responding')}</span>
            </div>
          )}

          {/* 输入状态提示 */}
          {inputHint && (
            <span className={clsx(
              'flex items-center gap-1.5',
              inputHint.type === 'accent' && 'text-accent',
              inputHint.type === 'violet' && 'text-violet-500'
            )}>
              {inputHint.type !== 'default' && <span className="w-1.5 h-1.5 bg-current rounded-full animate-pulse" />}
              {attachmentCount > 0 && inputHint.type === 'default' && <Paperclip size={12} />}
              {inputHint.text}
            </span>
          )}

          {/* 字数 */}
          {inputLength > 0 && (
            <span className="text-text-tertiary">{inputLength}</span>
          )}
        </div>
      </div>

      {/* 折叠面板：低频选择器（agent/permission） */}
      {hasOverflow && (
        <div className={clsx(
          'transition-opacity duration-200',
          expanded ? 'opacity-100 overflow-visible' : 'opacity-0 overflow-hidden',
        )}>
          <div className="flex flex-col gap-1 py-2 border-t border-border-subtle/50">
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
