/**
 * 空状态组件
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { FolderOpen, Code, FileSearch, Bot } from 'lucide-react';

export const EmptyState = memo(function EmptyState() {
  const { t } = useTranslation('chat');

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4">
      {/* 图标 */}
      <div className="w-16 h-16 rounded-2xl bg-primary-faint flex items-center justify-center mb-4">
        <Bot className="w-8 h-8 text-primary" />
      </div>

      {/* 标题 */}
      <h1 className="text-2xl font-semibold text-text-primary mb-2">
        {t('welcome.title')}
      </h1>

      {/* 描述 */}
      <p className="text-text-secondary mb-8 max-w-md">
        {t('welcome.description')}
      </p>

      {/* 功能列表 */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-lg w-full">
        <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-background-surface border border-border shadow-soft hover:shadow-medium hover:border-border-strong transition-all">
          <div className="w-8 h-8 rounded-lg bg-success-faint flex items-center justify-center">
            <FolderOpen className="w-4 h-4 text-success" />
          </div>
          <span className="text-xs text-text-tertiary">{t('welcome.featureFileManage')}</span>
        </div>
        <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-background-surface border border-border shadow-soft hover:shadow-medium hover:border-border-strong transition-all">
          <div className="w-8 h-8 rounded-lg bg-warning-faint flex items-center justify-center">
            <Code className="w-4 h-4 text-warning" />
          </div>
          <span className="text-xs text-text-tertiary">{t('welcome.featureCodeEdit')}</span>
        </div>
        <div className="flex flex-col items-center gap-2 p-4 rounded-xl bg-background-surface border border-border shadow-soft hover:shadow-medium hover:border-border-strong transition-all">
          <div className="w-8 h-8 rounded-lg bg-primary-faint flex items-center justify-center">
            <FileSearch className="w-4 h-4 text-primary" />
          </div>
          <span className="text-xs text-text-tertiary">{t('welcome.featureSmartAnalysis')}</span>
        </div>
      </div>

      {/* 提示 */}
      <p className="text-text-tertiary text-sm mt-8">
        {t('welcome.hint')}
      </p>
    </div>
  );
});
