import { memo, useCallback, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { Plus } from 'lucide-react';
import { NewSessionPanel } from './NewSessionPanel';

/**
 * 新建会话按钮（状态栏 + 号）
 *
 * 面板体已抽为共享组件 NewSessionPanel（QuickSwitch「New Session」同源复用，
 * 见 plans/create-session-modal-slimdown-spec.md）；本组件只负责触发按钮与开合。
 */
export const NewSessionButton = memo(function NewSessionButton() {
  const { t } = useTranslation('chat');

  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const handleClose = useCallback(() => setIsOpen(false), []);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        onClick={() => setIsOpen(!isOpen)}
        className={clsx(
          'p-1.5 rounded transition-colors',
          isOpen
            ? 'bg-primary/10 text-primary'
            : 'text-text-muted hover:text-text-primary hover:bg-background-hover'
        )}
        title={t('newSession.title')}
      >
        <Plus className="w-4 h-4" />
      </button>

      {/* 面板向上展开（fixed + 视口钳制，防窄屏下越出右缘被裁剪） */}
      {isOpen && (
        <NewSessionPanel
          getAnchorRect={() => buttonRef.current?.getBoundingClientRect() ?? null}
          anchorEl={buttonRef.current}
          onClose={handleClose}
        />
      )}
    </div>
  );
});
