/**
 * 全局连接状态指示器（顶栏常驻）
 *
 * 静默加载模式下，引擎检测在后台进行、不阻塞主界面。
 * 此组件在 TopMenuBar 以非侵入方式反馈连接状态：
 * - connecting：转圈 + 文字，提示正在后台检测
 * - failed：警告图标，可点击唤出诊断/重连面板（onShowDiagnostics）
 * - success / needsToken：不渲染（success 保持顶栏简洁；needsToken 另有全屏 Token 输入）
 */

import { useTranslation } from 'react-i18next';
import { Loader2, AlertTriangle } from 'lucide-react';
import { clsx } from 'clsx';
import { useConfigStore } from '@/stores';

interface ConnectionStatusIndicatorProps {
  /** 点击「失败」状态时触发，用于唤出诊断/重连面板 */
  onShowDiagnostics?: () => void;
}

export function ConnectionStatusIndicator({ onShowDiagnostics }: ConnectionStatusIndicatorProps) {
  const { t } = useTranslation('common');
  const connectionState = useConfigStore(state => state.connectionState);

  if (connectionState === 'connecting') {
    return (
      <div
        className="flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs text-text-tertiary select-none"
        data-tauri-drag-region={false}
      >
        <Loader2 size={12} className="animate-spin shrink-0" />
        <span className="truncate">{t('connection.statusConnecting')}</span>
      </div>
    );
  }

  if (connectionState === 'failed') {
    return (
      <button
        type="button"
        onClick={onShowDiagnostics}
        className={clsx(
          'flex items-center gap-1.5 px-2 py-0.5 rounded-md text-xs',
          'text-amber-500 hover:bg-amber-500/10 transition-colors',
        )}
        title={t('connection.statusFailedAction')}
        data-tauri-drag-region={false}
      >
        <AlertTriangle size={12} className="shrink-0" />
        <span className="truncate">{t('connection.statusFailed')}</span>
      </button>
    );
  }

  // success / needsToken：不渲染
  return null;
}
