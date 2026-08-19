/**
 * 性能开关迁移引导横幅
 *
 * 首次升级到"默认全关"版本时显示，引导用户了解性能开关体系。
 * dismiss 后持久化到 config.perfMigrationDismissed，跨设备同步不再显示。
 *
 * 显示条件（由父层/PerformanceTab 判断并控制渲染）：
 * - config.performance 所有字段为 false（默认状态）
 * - 且 config.perfMigrationDismissed !== true
 *
 * 本组件仅负责展示与 dismiss 动作。
 */

import { useTranslation } from 'react-i18next';
import { useState } from 'react';

interface PerfMigrationBannerProps {
  /** dismiss 回调：父层负责写入 config.perfMigrationDismissed=true */
  onDismiss: () => void;
  /** 跳转到具体开关的回调（可选，父层可滚动到目标开关） */
  onGoSettings?: () => void;
}

export function PerfMigrationBanner({ onDismiss, onGoSettings }: PerfMigrationBannerProps) {
  const { t } = useTranslation('settings');
  const [dismissing, setDismissing] = useState(false);

  const handleDismiss = () => {
    setDismissing(true);
    onDismiss();
  };

  return (
    <div
      role="region"
      aria-label={t('performance.migrationBanner.title', '性能优化更新')}
      className="p-4 rounded-lg bg-primary/5 border border-primary/30 mb-4"
    >
      <div className="flex items-start gap-3">
        {/* 图标 */}
        <svg
          className="w-5 h-5 text-primary shrink-0 mt-0.5"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M13 10V3L4 14h7v7l9-11h-7z"
          />
        </svg>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-text-primary">
            {t('performance.migrationBanner.title', '性能优化更新')}
          </p>
          <p className="text-xs text-text-muted mt-1">
            {t(
              'performance.migrationBanner.body',
              '为获得最佳性能，资源密集型功能（文件监听、LSP 索引、图表渲染等）已默认关闭。按需开启对应开关即可恢复功能，配置即时生效无需重启。',
            )}
          </p>

          <div className="flex items-center gap-2 mt-3">
            {onGoSettings && (
              <button
                onClick={onGoSettings}
                className="px-3 py-1.5 text-xs bg-primary text-white rounded-md hover:bg-primary/90 transition-colors"
              >
                {t('performance.migrationBanner.goSettings', '查看开关')}
              </button>
            )}
            <button
              onClick={handleDismiss}
              disabled={dismissing}
              className="px-3 py-1.5 text-xs text-text-secondary bg-background-hover rounded-md hover:bg-background-base transition-colors disabled:opacity-50"
            >
              {t('performance.migrationBanner.dismiss', '知道了')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
