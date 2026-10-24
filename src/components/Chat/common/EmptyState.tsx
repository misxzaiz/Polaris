/**
 * 空状态组件
 */

import { memo } from 'react';
import { useTranslation } from 'react-i18next';

export const EmptyState = memo(function EmptyState() {
  const { t } = useTranslation('chat');

  return (
    <div className="flex flex-col items-center justify-center h-full text-center px-4">

      {/* 提示 */}
      <p className="text-text-tertiary text-sm mt-8">
        {t('welcome.hint')}
      </p>
    </div>
  );
});
