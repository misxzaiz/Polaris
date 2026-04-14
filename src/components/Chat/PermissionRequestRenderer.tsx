/**
 * 权限请求块渲染器组件
 *
 * 用于工具调用被拒绝时的权限确认界面
 * - 显示被拒绝的工具列表和原因
 * - 允许用户批准或拒绝
 * - 支持键盘导航
 */

import { memo, useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Shield, AlertTriangle, CheckCircle, XCircle, ChevronDown, ChevronRight } from 'lucide-react';
import { sessionStoreManager } from '../../stores/conversationStore/sessionStoreManager';
import { Button } from '../Common/Button';
import type { PermissionRequestBlock } from '../../types';

export interface PermissionRequestRendererProps {
  block: PermissionRequestBlock;
}

export const PermissionRequestRenderer = memo(function PermissionRequestRenderer({ block }: PermissionRequestRendererProps) {
  const { t } = useTranslation('chat');
  const [isProcessing, setIsProcessing] = useState(false);
  const [expandedDenial, setExpandedDenial] = useState<number | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // 本地决策状态，用户操作后立即生效
  const [localStatus, setLocalStatus] = useState<'pending' | 'approved' | 'denied'>('pending');

  // 通过 block.sessionId（后端 conversationId）反查前端 store
  // stores map key 是前端 UUID，block.sessionId 是后端 conversationId，需遍历匹配
  const findStore = useCallback(() => {
    const stores = sessionStoreManager.getState().stores
    for (const [, store] of stores) {
      const state = store.getState()
      if (state.conversationId === block.sessionId) {
        return state
      }
    }
    return null
  }, [block.sessionId])

  const isHandled = localStatus !== 'pending';

  // 处理批准
  const handleApprove = useCallback(async () => {
    if (isHandled || isProcessing) return;

    setIsProcessing(true);
    setLocalStatus('approved');
    try {
      const deniedToolNames = [...new Set(block.denials.map(d => d.toolName))];
      const store = findStore();
      if (store) {
        await store.continueChat(`[已授权] ${deniedToolNames.join(', ')}`, deniedToolNames);
      }
    } catch (error) {
      console.error('[PermissionRequest] 批准操作失败:', error);
    } finally {
      setIsProcessing(false);
    }
  }, [isHandled, isProcessing, block.denials, findStore]);

  // 处理拒绝
  const handleDeny = useCallback(async () => {
    if (isHandled || isProcessing) return;

    setIsProcessing(true);
    setLocalStatus('denied');
    try {
      const decisionPrompt = `[权限确认] 用户拒绝了操作\n工具: ${block.denials.map(d => d.toolName).join(', ')}`;
      const store = findStore();
      if (store) {
        await store.continueChat(decisionPrompt);
      }
    } catch (error) {
      console.error('[PermissionRequest] 拒绝操作失败:', error);
    } finally {
      setIsProcessing(false);
    }
  }, [isHandled, isProcessing, block.denials, findStore]);

  // 键盘导航处理
  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (isHandled || isProcessing) return;

    switch (event.key) {
      case 'Enter':
        if (event.shiftKey) {
          event.preventDefault();
          handleDeny();
        } else {
          event.preventDefault();
          handleApprove();
        }
        break;
      case 'Escape':
        event.preventDefault();
        break;
    }
  }, [isHandled, isProcessing, handleApprove, handleDeny]);

  // 自动聚焦
  useEffect(() => {
    if (!isHandled && containerRef.current) {
      containerRef.current.focus();
    }
  }, [isHandled]);

  // ===== 已处理：紧凑一行显示 =====
  if (localStatus === 'approved') {
    const toolNames = [...new Set(block.denials.map(d => d.toolName))].join(', ');
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-green-500/10 border border-green-500/20 text-sm">
        <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
        <span className="text-green-600">{t('permissionRequest.approved', '已授权')}</span>
        <span className="font-mono text-xs text-text-tertiary">{toolNames}</span>
      </div>
    );
  }

  if (localStatus === 'denied') {
    return (
      <div className="flex items-center gap-2 px-3 py-1.5 rounded bg-red-500/10 border border-red-500/20 text-sm">
        <XCircle className="w-4 h-4 text-red-500 shrink-0" />
        <span className="text-red-600">{t('permissionRequest.denied', '已拒绝')}</span>
      </div>
    );
  }

  // ===== 待处理：完整面板 =====
  return (
    <div
      ref={containerRef}
      className={clsx(
        'rounded-lg border p-4 transition-all',
        'bg-amber-500/10 border-amber-500/30',
        'focus:ring-2 focus:ring-amber-500 focus:outline-none'
      )}
      role="region"
      aria-label={t('permissionRequest.ariaLabel', '权限请求')}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      {/* 标题栏 */}
      <div className="flex items-center gap-2 mb-3">
        <Shield className="w-5 h-5 text-amber-500" />
        <span className="font-medium text-sm">
          {t('permissionRequest.title', '权限请求')}
        </span>
        <span className="text-xs text-muted ml-auto">
          {block.denials.length} {t('permissionRequest.items', '项')}
        </span>
      </div>

      {/* 拒绝详情列表 */}
      <div className="space-y-2 mb-4 max-h-[200px] overflow-y-auto">
        {block.denials.map((denial, index) => (
          <div
            key={index}
            className={clsx(
              'rounded border border-base-300 bg-base-100/50',
              'text-sm'
            )}
          >
            {/* 工具名称行 */}
            <button
              type="button"
              className={clsx(
                'w-full flex items-center gap-2 p-2 text-left',
                'hover:bg-base-200/50 transition-colors',
                'focus:outline-none focus:ring-1 focus:ring-primary'
              )}
              onClick={() => setExpandedDenial(prev => prev === index ? null : index)}
              aria-expanded={expandedDenial === index}
            >
              {expandedDenial === index ? (
                <ChevronDown className="w-4 h-4 text-muted shrink-0" />
              ) : (
                <ChevronRight className="w-4 h-4 text-muted shrink-0" />
              )}
              <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
              <span className="font-mono text-xs font-medium truncate">
                {denial.toolName}
              </span>
            </button>

            {/* 详情展开区域 */}
            {expandedDenial === index && (
              <div className="px-2 pb-2 pt-0 border-t border-base-300">
                <div className="mt-2 text-xs text-muted">
                  <div className="font-medium mb-1">
                    {t('permissionRequest.reason', '原因')}:
                  </div>
                  <div className="pl-2 text-foreground/80">
                    {denial.reason}
                  </div>
                </div>

                {/* 额外信息 */}
                {denial.extra && Object.keys(denial.extra).length > 0 && (
                  <div className="mt-2 text-xs">
                    <div className="font-medium text-muted mb-1">
                      {t('permissionRequest.details', '详情')}:
                    </div>
                    <pre className="pl-2 text-foreground/60 overflow-x-auto">
                      {JSON.stringify(denial.extra, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center gap-2 pt-2 border-t border-base-300">
        <Button
          variant="primary"
          size="sm"
          onClick={handleApprove}
          disabled={isProcessing}
          className="flex-1"
          aria-label={t('permissionRequest.approveAriaLabel', '批准操作')}
        >
          {isProcessing
            ? t('permissionRequest.processing', '处理中...')
            : t('permissionRequest.approve', '批准')
          }
        </Button>
        <Button
          variant="secondary"
          size="sm"
          onClick={handleDeny}
          disabled={isProcessing}
          className="flex-1"
          aria-label={t('permissionRequest.denyAriaLabel', '拒绝操作')}
        >
          {t('permissionRequest.deny', '拒绝')}
        </Button>
      </div>
    </div>
  );
});

/**
 * 简化版权限请求渲染器（用于归档层）
 */
export const SimplifiedPermissionRequestRenderer = memo(function SimplifiedPermissionRequestRenderer({ block }: PermissionRequestRendererProps) {
  const { t } = useTranslation('chat');

  const isApproved = block.status === 'approved';
  const iconClass = isApproved ? 'text-green-500' : 'text-red-500';
  const Icon = isApproved ? CheckCircle : XCircle;

  return (
    <div
      className={clsx(
        'flex items-center gap-2 px-3 py-2 rounded',
        'bg-base-200/50 text-sm'
      )}
      role="region"
      aria-label={`${t('permissionRequest.ariaLabel', '权限请求')}: ${isApproved ? t('permissionRequest.approved', '已授权') : t('permissionRequest.denied', '已拒绝')}`}
      aria-hidden="true"
    >
      <Icon className={clsx('w-4 h-4', iconClass)} />
      <span className="text-muted">
        {t('permissionRequest.permissionRequest', '权限请求')}
      </span>
      <span className="text-xs text-muted ml-auto">
        {block.denials.length} {t('permissionRequest.items', '项')}
      </span>
    </div>
  );
});

export default PermissionRequestRenderer;
